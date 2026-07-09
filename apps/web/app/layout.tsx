import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GlassBox — 可验证的深度研究引擎",
  description:
    "输入一个课题,产出每句话可溯源的引用级报告;思考过程像玻璃盒一样可看、可回放。当前为 M0 骨架:耐久任务最小闭环。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
