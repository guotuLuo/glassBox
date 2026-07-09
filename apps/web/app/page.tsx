import { TaskConsole } from "@/components/task-console";
import { Badge } from "@/components/ui/badge";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10">
      <header className="mb-8 flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary font-semibold text-primary-foreground">
          G
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-semibold tracking-tight">GlassBox</h1>
          <p className="text-sm text-muted-foreground">可验证的深度研究引擎 · 玻璃盒里的 agent</p>
        </div>
        <Badge variant="outline">M0 · hello loop</Badge>
      </header>
      <TaskConsole />
      <footer className="mt-10 text-center text-xs text-muted-foreground">
        提交 → PG 入队 → worker <span className="font-mono">SKIP LOCKED</span> 认领 → 事件表 →
        NOTIFY → SSE → 实时渲染
      </footer>
    </main>
  );
}
