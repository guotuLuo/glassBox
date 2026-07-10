import { Module } from "@nestjs/common";
import { DbLifecycle, dbProvider } from "./db.provider.js";
import { HealthController } from "./health.controller.js";
import { RagController } from "./rag.controller.js";
import { TaskEventsRelay } from "./task-events.relay.js";
import { TasksController } from "./tasks.controller.js";

@Module({
  controllers: [TasksController, HealthController, RagController],
  providers: [dbProvider, DbLifecycle, TaskEventsRelay],
})
export class AppModule {}
