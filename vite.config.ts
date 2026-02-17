// vite.config.ts
import { defineConfig } from 'vite'
// 如果你用 React，必须导入这个插件（没有的话先安装：npm install @vitejs/plugin-react -D）
import react from '@vitejs/plugin-react'

// 核心配置：base 必须和仓库名一致，结尾的 / 不能少！
export default defineConfig({
  // 关键：base 路径 = /仓库名/，你的仓库名是 daily-three-sentences
  base: '/daily-three-sentences/',
  // 如果你用 React，添加这个插件（没有的话会报错）
  plugins: [react()],
  // 其他原有配置保留（比如 build、server 等）
})
