import { defineConfig } from 'vite'
import path from 'path'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  base: '/daily-three-sentences/',
  build: {
    modulePreload: {
      polyfill: false,
      resolveDependencies: (filename, deps) => {
        if (filename.includes('index')) {
          return deps.filter(dep => 
            dep.includes('vendor-react') || 
            dep.includes('fsrs')
          );
        }
        return deps;
      }
    },
    rollupOptions: {
      output: {
        manualChunks: (id: string) => {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom')) return 'vendor-react';
            if (id.includes('@supabase')) return 'vendor-supabase';
            if (id.includes('xlsx')) return 'vendor-xlsx';
            if (id.includes('recharts')) return 'vendor-recharts';
          }
          if (id.includes('services/fsrsService')) return 'fsrs';
          if (id.includes('pages/StudyPage/components')) return 'components';
        }
      }
    },
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
        pure_funcs: ['console.log', 'console.info', 'console.debug', 'console.warn']
      }
    }
  },
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
        orientation: 'portrait', // 锁定竖屏
        icons: [
          {
            src: 'icons/apple-touch-icon-180x180.png',
            sizes: '180x180',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'icons/apple-touch-icon-167x167.png',
            sizes: '167x167',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'icons/apple-touch-icon-152x152.png',
            sizes: '152x152',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'icons/apple-touch-icon-120x120.png',
            sizes: '120x120',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'icons/apple-touch-icon.png',
            sizes: 'any',
            type: 'image/png',
            purpose: 'maskable'
          }
        ],
        categories: ['education', 'productivity'],
        lang: 'zh-CN',
        dir: 'ltr'
      },
      // Workbox核心配置：缓存规则
      workbox: {
        // 预缓存：打包后的所有静态资源（HTML/JS/CSS/图片/图标）
        globPatterns: ['**/*.{html,js,css,ico,png,svg,jpg,jpeg,woff,woff2,ttf}'],
        // 排除大图标文件（超过2MB的文件）
        globIgnores: ['icons/apple-touch-icon*.png'],
        // 最大缓存文件大小：4MB（默认2MB，图标文件较大）
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // 启用跳过等待和客户端声明，确保新SW立即激活
        skipWaiting: true,
        clientsClaim: true,
        // 运行时缓存：拦截接口请求，优化手机端网络请求速度
        runtimeCaching: [
          {
            // 缓存Supabase的REST API（核心：修复数据不一致问题）
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/v1\/.*$/,
            // 改为 NetworkFirst：确保用户在线时看到的是最新进度
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-api-cache',
              networkTimeoutSeconds: 5, // 如果5秒内网络没响应，再转用缓存，避免长时间白屏
              expiration: {
                maxAgeSeconds: 7 * 24 * 60 * 60, // 增加到7天，方便离线时复习
                maxEntries: 100
              },
              cacheableResponse: {
                statuses: [0, 200] // 0 是为了处理跨域请求的响应
              }
            }
          },
          {
            // 缓存Supabase的鉴权API（兜底）
            urlPattern: /^https:\/\/.*\.supabase\.co\/auth\/v1\/.*$/,
            handler: 'NetworkFirst', // 网络优先：鉴权接口需保证实时性
            options: { cacheName: 'supabase-auth-cache', expiration: { maxAgeSeconds: 60 * 10 } }
          },
          {
            // 缓存语音/其他第三方接口（如果有）
            urlPattern: /^https:\/\/.*\.googleapis\.com\/.*$/,
            handler: 'NetworkFirst',
            options: { cacheName: 'third-party-api-cache' }
          },
          {
            // 缓存CDN资源
            urlPattern: /^https:\/\/(cdn\.jsdelivr\.net|cdn\.staticfile\.org)\/.*$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cdn-cache',
              expiration: {
                maxAgeSeconds: 7 * 24 * 60 * 60, // 缓存7天
                maxEntries: 50
              }
            }
          },
          {
            // 缓存字体资源
            urlPattern: /\.(woff|woff2|ttf|eot)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'font-cache',
              expiration: {
                maxAgeSeconds: 30 * 24 * 60 * 60, // 缓存30天
                maxEntries: 20
              }
            }
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