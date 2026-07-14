import {
  type ApprovalDecision,
  approvalDecisionSchema,
  type PendingApproval,
} from "@glassbox/contracts";
import { listEventsAfter, listPendingApprovals, resolveApproval } from "@glassbox/core";
import type { DbHandle } from "@glassbox/db";
import { Body, Controller, Get, Inject, NotFoundException, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "./db.provider.js";
import { ZodValidationPipe } from "./zod.pipe.js";

const uuidPipe = new ZodValidationPipe(z.uuid());

/** 审批台(人在环路):列待审批任务、批准/拒绝 */
@Controller("api/approvals")
export class ApprovalsController {
  constructor(@Inject(DB) private readonly dbh: DbHandle) {}

  @Get()
  async pending(): Promise<PendingApproval[]> {
    const rows = await listPendingApprovals(this.dbh.db);
    // reason 来自 approval.requested 事件
    return Promise.all(
      rows.map(async (t) => {
        const events = await listEventsAfter(this.dbh.db, t.id, 0);
        const req = events.find((e) => e.eventType === "approval.requested");
        const request = t.request as { message?: string; question?: string } | null;
        return {
          taskId: t.id,
          agentName: t.agentName,
          reason: req?.message ?? "需要审批",
          summary: request?.message ?? request?.question ?? null,
          createdAt: t.createdAt.toISOString(),
        };
      }),
    );
  }

  @Post(":id")
  async resolve(
    @Param("id", uuidPipe) id: string,
    @Body(new ZodValidationPipe(approvalDecisionSchema)) body: ApprovalDecision,
  ): Promise<{ ok: boolean }> {
    const ok = await resolveApproval(this.dbh.db, id, body.decision, body.note);
    if (!ok) throw new NotFoundException(`task ${id} is not awaiting approval`);
    return { ok };
  }
}
