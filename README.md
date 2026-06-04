<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1kzk_QAyXVPqWgEBlOHSnQ9UudqyCNrl3

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Voice Configuration / 语音配置

本项目支持多种 TTS 引擎，语音配置统一管理于 [`src/services/elevenLabsVoices.ts`](src/services/elevenLabsVoices.ts)。

### 支持的 TTS 引擎

| 引擎 | 优先级 | 说明 |
|------|--------|------|
| ElevenLabs | 首选 | 高质量自然语音，需 API Key |
| MiniMax | 备选 | 中文支持好 |
| EdgeTTS | 备选 | 免费无需 Key |
| Web Speech API | 降级 | 浏览器内置，跨平台兼容 |

### ElevenLabs 美式英语语音策略

**数据源**: [ElevenLabs Official Default Voices](https://elevenlabs.io/docs/product/voices/default-voices)

**听力学习推荐语音**（`RECOMMENDED_VOICE_IDS`）:

| 优先级 | 语音 | 特点 | 适用场景 |
|--------|------|------|----------|
| 1 | **Liam** | articulate narration | 叙事朗读、听力练习首选 |
| 2 | **Sarah** | soft news | 新闻播报、清晰女声 |
| 3 | **Chris** | casual conversational | 日常对话、自然流畅 |

**完整美式英语语音列表**（`DEFAULT_VOICES`）:

| 语音 | 特点 | 语音 | 特点 |
|------|------|------|------|
| Liam | articulate narration | Laura | upbeat social media |
| Sarah | soft news | Matilda | friendly narration |
| Chris | casual conversational | Will | friendly social media |
| Jessica | expressive conversational | Eric | friendly conversational |
| Bill | trustworthy narration | Brian | deep narration |
| Aria | expressive social media | Roger | confident social media |
| River | confident neutral | | |

### 配置架构

```
src/services/elevenLabsVoices.ts  ← 单一数据源
    ├── DEFAULT_VOICES[]         ← 13 个官方语音定义
    └── RECOMMENDED_VOICE_IDS[]  ← 前3个推荐语音 ID
```

所有引用处通过 `RECOMMENDED_VOICE_IDS` 常量引用，未来更换语音只需修改一处。

### 修改推荐语音

编辑 [`src/services/elevenLabsVoices.ts`](src/services/elevenLabsVoices.ts)，调整 `DEFAULT_VOICES` 数组顺序即可自动更新推荐列表。

### 参数说明

ElevenLabs 使用官方默认参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| model | eleven_v3 | 最新 expressive 模型 |
| output_format | mp3_44100_128 | 高质量 MP3 |
| stability | 0.5 | API 自动应用 |
| similarity_boost | 0.75 | API 自动应用 |
| style | 0 | API 自动应用 |
| speaker_boost | true | API 自动应用 |
