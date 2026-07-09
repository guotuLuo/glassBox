import { Module } from "@nestjs/common";
import { dbProvider } from "./db.provider.js";
import { WorkerService } from "./worker.service.js";

@Module({
  providers: [dbProvider, WorkerService],
})
export class WorkerModule {}
