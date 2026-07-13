import { Module } from "@nestjs/common";
import { DbLifecycle, dbProvider } from "./db.provider.js";
import { EvalsController } from "./evals.controller.js";
import { HealthController } from "./health.controller.js";
import { RagController } from "./rag.controller.js";
import { TaskEventsRelay } from "./task-events.relay.js";
import { TasksController } from "./tasks.controller.js";
import { ThrottleGuard } from "./throttle.guard.js";

@Module({
  controllers: [TasksController, HealthController, RagController, EvalsController],
  providers: [dbProvider, DbLifecycle, TaskEventsRelay, ThrottleGuard],
})
export class AppModule {}
