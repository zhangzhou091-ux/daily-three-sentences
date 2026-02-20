// vite.config.ts
import { defineConfig } from 'vite'
// 导入React插件（确保已安装：npm install @vitejs/plugin-react -D）
import react from '@vitejs/plugin-react'

// Vite核心配置
export default defineConfig({
  // 关键：匹配GitHub仓库名的基础路径，解决GitHub Pages部署后静态资源404问题
  base: '/daily-three-sentences/',
  // React项目必须的插件，处理React语法和热更新
  plugins: [react()],
  // 可选配置：优化开发体验（保留默认即可，无需额外修改）
  server: {
    // 允许局域网设备访问（手机同网预览用）
    host: '0.0.0.0',
    // 默认端口，可根据需要修改
    port: 5173,
    // 自动打开浏览器
    open: true
  }
})