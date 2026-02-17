// vite.config.ts
import { defineConfig } from 'vite'
// 导入React插件（确保已安装：npm install @vitejs/plugin-react -D）
import react from '@vitejs/plugin-react'

// Vite核心配置
export default defineConfig({
  // 关键：匹配GitHub仓库名的基础路径，解决手机端404问题
  base: '/daily-three-sentences/',
  // React项目必须的插件，缺一不可
  plugins: [react()],
  // 可选：保留Vite默认的其他配置（无需额外修改）
})