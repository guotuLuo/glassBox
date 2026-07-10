import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { loadEnv } from "./env.js";
import { WorkerModule } from "./worker.module.js";

loadEnv();

// Node 的 fetch 不认 HTTP(S)_PROXY 环境变量;开发机抓外网需显式挂代理。
// 生产服务器有自己的出口,不设 OUTBOUND_PROXY 即直连。
const outboundProxy = process.env.OUTBOUND_PROXY ?? process.env.HTTPS_PROXY;
if (outboundProxy) {
  setGlobalDispatcher(new ProxyAgent(outboundProxy));
  new Logger("bootstrap").log(`outbound fetch via proxy ${outboundProxy}`);
}

async function bootstrap(): Promise<void> {
  // standalone 进程:无 HTTP,纯 agent runtime 宿主(总纲 §5)
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  new Logger("bootstrap").log("glassbox worker started");
}

void bootstrap();
