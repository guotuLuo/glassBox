import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { loadEnv } from "./env.js";

loadEnv();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // M0 宽松 CORS(web 直连 3001);M5 治理阶段收紧为白名单
  app.enableCors({ origin: true });
  app.enableShutdownHooks();
  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
  new Logger("bootstrap").log(`glassbox api listening on :${port}`);
}

void bootstrap();
