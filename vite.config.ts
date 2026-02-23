import { defineConfig } from 'vite'
// 导入React插件
import react from '@vitejs/plugin-react'
// 导入PWA核心插件
import { VitePWA } from 'vite-plugin-pwa'

// Vite核心配置
export default defineConfig({
  // 保留：GitHub Pages部署的基础路径
  base: '/daily-three-sentences/',
  // 保留+新增：原有react插件 + PWA插件
  plugins: [
    react(),
    // 新增：PWA核心配置（预缓存+运行时缓存+应用清单）
    VitePWA({
      // 自动注册Service Worker，自动更新，无需用户手动刷新
      registerType: 'autoUpdate',
      // 关闭开发环境SW（避免开发时缓存干扰，仅生产环境生效）
      devOptions: { enabled: false },
      // PWA应用清单（添加到手机主屏幕的配置）
      manifest: {
        name: '每日三句 - 英语学习',
        short_name: '每日三句',
        description: '基于艾宾浩斯遗忘曲线的英语句子学习/复习工具',
        start_url: '/daily-three-sentences/', // 匹配你的base路径，必须一致！
        display: 'standalone', // 独立窗口运行，模拟原生APP
        background_color: '#f5f5f7', // 启动页背景色（匹配你的项目主题）
        theme_color: '#f5f5f7', // 状态栏主题色（匹配你的项目主题）
        icons: [
          // 手机端主屏幕图标，需放到项目public文件夹下（建议做192/512两个尺寸）
          {
            src: 'icon-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable'
          },
          {
            src: 'icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      // Workbox核心配置：缓存规则
      workbox: {
        // 预缓存：打包后的所有静态资源（HTML/JS/CSS/图片/图标）
        globPatterns: ['**/*.{html,js,css,ico,png,svg,jpg,jpeg}'],
        // 运行时缓存：拦截接口请求，优化手机端网络请求速度
        runtimeCaching: [
          {
            // 缓存Supabase的REST API（核心：优化云同步速度）
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/v1\/.*/,
            handler: 'CacheFirst', // 缓存优先：适配手机端弱网，第一次请求后后续从缓存取
            options: {
              cacheName: 'supabase-api-cache', // 缓存名称
              expiration: {
                maxAgeSeconds: 24 * 60 * 60, // 缓存1天，兼顾新鲜度和速度
                maxEntries: 100 // 最多缓存100个接口请求，避免缓存过大
              },
              cacheableResponse: { statuses: [200] } // 仅缓存成功的请求
            }
          },
          {
            // 缓存Supabase的鉴权API（兜底）
            urlPattern: /^https:\/\/.*\.supabase\.co\/auth\/v1\/.*/,
            handler: 'NetworkFirst', // 网络优先：鉴权接口需保证实时性
            options: { cacheName: 'supabase-auth-cache', expiration: { maxAgeSeconds: 60 * 10 } }
          },
          {
            // 缓存语音/其他第三方接口（如果有）
            urlPattern: /^https:\/\/.*\.googleapis\.com\/.*/,
            handler: 'NetworkFirst',
            options: { cacheName: 'third-party-api-cache' }
          }
        ]
      }
    })
  ],
  // 保留：开发服务器配置（手机同网预览）
  server: {
    host: '0.0.0.0',
    port: 5173,
    open: true
  }
})