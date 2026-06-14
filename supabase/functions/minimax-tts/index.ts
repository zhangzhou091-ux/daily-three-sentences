const MINIMAX_API_KEY = Deno.env.get("MINIMAX_API_KEY")

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
}

const jsonHeaders = Object.assign({}, corsHeaders, { "Content-Type": "application/json" })
const audioHeaders = Object.assign({}, corsHeaders, { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" })

const DEFAULT_VOICE_ID = "English_expressive_narrator"
const MAX_TEXT_LENGTH = 10000

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

function base64ToBytes(b64) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: jsonHeaders }
    )
  }

  if (!MINIMAX_API_KEY) {
    console.error("MINIMAX_API_KEY environment variable is not set")
    return new Response(
      JSON.stringify({ error: "MINIMAX_API_KEY 未配置，请在 Supabase 后台 Settings → Edge Functions 中添加环境变量 MINIMAX_API_KEY" }),
      { status: 500, headers: jsonHeaders }
    )
  }

  try {
    let body
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: "请求体格式错误，需要 JSON" }),
        { status: 400, headers: jsonHeaders }
      )
    }

    const text = body.text
    const voiceId = body.voice_id || DEFAULT_VOICE_ID

    if (!text || !text.trim()) {
      return new Response(
        JSON.stringify({ error: "文本为空" }),
        { status: 400, headers: jsonHeaders }
      )
    }

    if (text.trim().length > MAX_TEXT_LENGTH) {
      return new Response(
        JSON.stringify({ error: "文本过长，最大支持 " + MAX_TEXT_LENGTH + " 字符" }),
        { status: 400, headers: jsonHeaders }
      )
    }

    console.log("MiniMax TTS request: text=\"" + text.trim().slice(0, 50) + "...\" voice_id=" + voiceId)

    const response = await fetch("https://api.minimaxi.com/v1/t2a_v2", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + MINIMAX_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "speech-2.8-hd",
        text: text.trim(),
        stream: false,
        voice_setting: {
          voice_id: voiceId,
          speed: 1,
          vol: 1,
          pitch: 0,
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: "mp3",
          channel: 1,
        },
        language_boost: "auto",
        output_format: "hex",
      }),
    })

    if (!response.ok) {
      let errorMsg = "MiniMax API 错误 (" + response.status + ")"
      try {
        const errorData = await response.json()
        if (errorData && errorData.base_resp && errorData.base_resp.status_msg) {
          errorMsg = errorData.base_resp.status_msg
        } else if (errorData && errorData.message) {
          errorMsg = errorData.message
        }
      } catch {}
      console.error("MiniMax API error " + response.status + ": " + errorMsg)
      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status: response.status >= 500 ? 502 : response.status, headers: jsonHeaders }
      )
    }

    const result = await response.json()

    if (result && result.base_resp && result.base_resp.status_code !== 0) {
      const errMsg = (result.base_resp && result.base_resp.status_msg) || "MiniMax API 返回错误"
      console.error("MiniMax API base_resp error:", errMsg)
      return new Response(
        JSON.stringify({ error: errMsg }),
        { status: 502, headers: jsonHeaders }
      )
    }

    let audioBytes

    if (result && result.data && result.data.audio) {
      audioBytes = hexToBytes(result.data.audio)
    } else if (result && result.audio_file) {
      audioBytes = base64ToBytes(result.audio_file)
    }

    if (!audioBytes || audioBytes.length === 0) {
      return new Response(
        JSON.stringify({ error: "MiniMax 返回空音频数据" }),
        { status: 502, headers: jsonHeaders }
      )
    }

    console.log("MiniMax TTS success: " + audioBytes.length + " bytes")

    return new Response(audioBytes, { headers: audioHeaders })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error("MiniMax TTS Edge Function error:", msg)
    return new Response(
      JSON.stringify({ error: "服务内部错误: " + msg }),
      { status: 500, headers: jsonHeaders }
    )
  }
})
