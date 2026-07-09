import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { loadEnv } from "./env.js";
import { WorkerModule } from "./worker.module.js";

loadEnv();

async function bootstrap(): Promise<void> {
  // standalone 进程:无 HTTP,纯 agent runtime 宿主(总纲 §5)
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  new Logger("bootstrap").log("glassbox worker started");
}

void bootstrap();
