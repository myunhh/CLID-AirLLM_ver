import asyncio
import uvicorn
from fastapi import FastAPI, Request

app = FastAPI()
_global_airllm_model = None

@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """LiteLlm과 연동하기 위한 OpenAI 호환 엔드포인트"""
    body = await request.json()
    messages = body.get("messages", [])

    # 비동기 블로킹 방지를 위한 스레드 분리
    output_text = await asyncio.to_thread(_generate_with_airllm, messages)

    return {
        "id": "chatcmpl-airllm",
        "object": "chat.completion",
        "created": 1234567890,
        "model": "airllm-local",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": output_text
            },
            "finish_reason": "stop"
        }]
    }

def _generate_with_airllm(messages: list) -> str:
    global _global_airllm_model
    if _global_airllm_model is None:
        return "{\"error\": \"Model is None. Model failed to load in background.\"}"

    try:
        # ChatML 등 모델 공식 템플릿 적용
        prompt_text = _global_airllm_model.tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )

        inputs = _global_airllm_model.tokenizer(prompt_text, return_tensors="pt", return_attention_mask=False)

        outputs = _global_airllm_model.generate(
            inputs["input_ids"],
            max_new_tokens=1024,
            use_cache=True,
            return_dict_in_generate=True
        )

        # 모델 출력 중 프롬프트 이후 새로 생성된 부분만 디코딩
        input_length = inputs["input_ids"].shape[1]
        generated_ids = outputs.sequences[0][input_length:]
        response = _global_airllm_model.tokenizer.decode(generated_ids, skip_special_tokens=True).strip()

        return response
    except Exception as e:
        import traceback
        trace = traceback.format_exc()
        print(f"[AirLLM Error]\n{trace}")
        return f'{{"error": "Generation failed: {str(e)}" }}'

def run_local_server(model_path: str):
    """백그라운드에서 FastAPI 서버를 실행합니다."""
    global _global_airllm_model
    print(f"\n[Server] Loading AirLLM model from {model_path} ...")
    try:
        from airllm import AutoModel
        _global_airllm_model = AutoModel.from_pretrained(model_path)
    except ImportError:
        print("[Server] airllm is not installed. Please pip install airllm.")
    except Exception as e:
        import traceback
        trace = traceback.format_exc()
        print(f"\n[Fatal Error] 모델 로드에 실패했습니다. 서버를 시작할 수 없습니다:\n{trace}\n")
        # 서버 시작을 포기하고 종료합니다.
        import os
        os._exit(1)

    print("[Server] Starting OpenAI compatible mock server on http://127.0.0.1:8000 ...")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")
