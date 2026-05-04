# Kokoro-82M 本地模型文件

请将模型文件放置在此目录下。目录结构如下：

```
public/models/onnx-community/Kokoro-82M-v1.0-ONNX/
├── config.json
├── tokenizer.json
├── tokenizer_config.json
├── special_tokens_map.json
├── onnx/
│   └── model_q8.onnx
└── voices/
    ├── af_heart.bin
    ├── af_bella.bin
    └── ...
```

## 下载地址

- HuggingFace: https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main
- 镜像源: https://hf-mirror.com/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main

## 必需文件

1. `config.json` - 模型配置
2. `tokenizer.json` - 分词器
3. `tokenizer_config.json` - 分词器配置
4. `special_tokens_map.json` - 特殊 token 映射
5. `onnx/model_q8.onnx` - 量化模型文件 (~82MB)
6. `voices/*.bin` - 语音嵌入文件（每个约 512KB）

## 语音文件列表

- af_heart.bin, af_bella.bin, af_nicole.bin, af_kore.bin
- am_michael.bin, am_fenrir.bin, am_puck.bin
- bf_emma.bin, bm_george.bin

## 注意

- model_q8.onnx 文件较大（~82MB），请确保网络稳定
- 放置文件后需重新构建部署：`npm run build && git push`
