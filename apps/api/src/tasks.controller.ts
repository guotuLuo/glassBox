import {
  type CreateTaskRequest,
  type CreateTaskResponse,
  createTaskRequestSchema,
  type TaskDto,
} from "@glassbox/contracts";
import { enqueueTask, getTaskById, listEventsAfter } from "@glassbox/core";
import type { DbHandle, TaskRow } from "@glassbox/db";
import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { DB } from "./db.provider.js";
import { toTaskDto, toTaskEventDto } from "./mappers.js";
import { TaskEventsRelay } from "./task-events.relay.js";
import { ZodValidationPipe } from "./zod.pipe.js";

const HEARTBEAT_MS = 25_000;
const uuidPipe = new ZodValidationPipe(z.uuid());

@Controller("api/tasks")
export class TasksController {
  constructor(
    @Inject(DB) private readonly dbh: DbHandle,
    @Inject(TaskEventsRelay) private readonly relay: TaskEventsRelay,
  ) {}

  @Post()
  async create(
    @Body(new ZodValidationPipe(createTaskRequestSchema)) body: CreateTaskRequest,
  ): Promise<CreateTaskResponse> {
    const { task, inserted } = await enqueueTask(this.dbh.db, {
      agentName: body.agentName,
      request: body.input,
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    });
    return { task: toTaskDto(task), deduplicated: !inserted };
  }

  @Get(":id")
  async getById(@Param("id", uuidPipe) id: string): Promise<TaskDto> {
    const task = await this.findTask(id);
    return toTaskDto(task);
  }

  /**
   * SSE 事件流:先回放事件表(支持 Last-Event-ID 断线续传),再靠 LISTEN 门铃增量推送。
   * 心跳帧兼作兜底轮询,补偿中继断线窗口内可能丢失的 NOTIFY。
   */
  @Get(":id/events")
  async streamEvents(
    @Param("id", uuidPipe) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.findTask(id);

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write("retry: 3000\n\n");

    let cursor = this.resolveCursor(req);
    let closed = false;
    let pumping = false;

    const pump = async (): Promise<void> => {
      if (pumping || closed) return;
      pumping = true;
      try {
        while (!closed) {
          const rows = await listEventsAfter(this.dbh.db, id, cursor);
          if (rows.length === 0) break;
          for (const row of rows) {
            const dto = toTaskEventDto(row);
            res.write(`id: ${dto.id}\nevent: task_event\ndata: ${JSON.stringify(dto)}\n\n`);
            cursor = dto.id;
          }
        }
      } finally {
        pumping = false;
      }
    };

    const unsubscribe = this.relay.subscribe(id, () => void pump());
    const heartbeat = setInterval(() => {
      if (closed) return;
      res.write(": ping\n\n");
      void pump();
    }, HEARTBEAT_MS);

    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });

    await pump();
  }

  private async findTask(id: string): Promise<TaskRow> {
    const task = await getTaskById(this.dbh.db, id);
    if (!task) throw new NotFoundException(`task ${id} not found`);
    return task;
  }

  private resolveCursor(req: Request): number {
    const header = req.headers["last-event-id"];
    const raw = Array.isArray(header) ? header[0] : (header ?? req.query.lastEventId);
    const parsed = Number(typeof raw === "string" ? raw : 0);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
}
