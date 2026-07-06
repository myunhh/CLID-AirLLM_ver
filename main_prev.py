import asyncio
import os
import threading

from app_server import run_local_server
from google.adk.models.lite_llm import LiteLlm
from google.adk.apps import App
from google.adk.runners import InMemoryRunner
from google.adk.sessions import InMemorySessionService
from schema import TaskGraph

from agents.orchestrator import create_orchestrator
from agents.workers import create_rag_agent, create_coding_agent, create_reviewer_agent
from dispatcher import DAGDispatcher

# ==============================================================================
# CLID: Coding-LLM Inference Dispatcher 진입점
# ==============================================================================

LOCAL_API_BASE = "http://127.0.0.1:8000/v1"
os.environ["OPENAI_API_KEY"] = "dummy-key"  # LiteLLM 로컬 프록시 구동용

local_model = LiteLlm(
    model="openai/airllm-local",
    api_base=LOCAL_API_BASE
)

async def main(user_request: str):
    # 1. 전문 분야별 에이전트 초기화
    orchestrator = create_orchestrator(local_model)
    rag_worker = create_rag_agent(local_model)
    coding_worker = create_coding_agent(local_model)
    reviewer_worker = create_reviewer_agent(local_model)
    
    if not user_request:
        user_request = "결제 모듈에 쿠폰 적용 로직 추가 및 테스트 검증."
    print(f"\n[System] CLID 워크플로우 시작: '{user_request}'")
    print("[System] 1. 메인 오케스트레이터가 작업 그래프(DAG) 생성 중...")
    
    # 3. 메인 오케스트레이터에 의한 DAG 생성
    orch_app = App(name="app_orchestrator", root_agent=orchestrator)
    orch_runner = InMemoryRunner(app=orch_app)
    
    print("\n[System] 메인 오케스트레이터 실행 중...")
    events = await orch_runner.run_debug(user_request, quiet=True)
    
    task_graph_json = None
    for event in events:
        content = getattr(event, "content", None)
        parts = getattr(content, "parts", []) if content else []
        if parts:
            text = "".join(getattr(p, "text", "") for p in parts)
            if text and "{" in text:
                task_graph_json = text
                
    from schema import TaskGraph
    import json
    
    if not task_graph_json:
        print("[Error] 오케스트레이터 응답에서 TaskGraph JSON을 찾지 못했습니다.")
        return
        
    try:
        cleaned_json = task_graph_json.replace("```json", "").replace("```", "").strip()
        parsed_dict = json.loads(cleaned_json)
        task_graph = TaskGraph(**parsed_dict)
    except Exception as e:
        print(f"[Error] TaskGraph 파싱 실패: {e}")
        return
        
    print(f"\n[System] 생성된 태스크 수: {len(task_graph.tasks)}")
    for t in task_graph.tasks:
        print(f"  - [{t.task_id}] ({t.task_type}) 소유파일: {t.target_files} | 선행작업: {t.depends_on}")
    
    # 4. DAG Dispatcher로 비동기 동적 라우팅 시작 (파일 소유권 격리 기반 실행)
    print("\n[System] 2. 스케줄러(Dispatcher)가 DAG 라우팅을 시작합니다...")
    dispatcher = DAGDispatcher(
        orchestrator_agent=orchestrator,
        rag_agent=rag_worker,
        coding_agent=coding_worker,
        reviewer_agent=reviewer_worker
    )
    
    await dispatcher.run_dag(task_graph)
    
if __name__ == "__main__":
    target_model_path = "Qwen/Qwen3-32B"
    
    # ---------------------------------------------------------
    # 로컬 서버 구동 (실제 LLM 연동)
    # ---------------------------------------------------------
    
    server_thread = threading.Thread(target=run_local_server, args=(target_model_path,), daemon=True)
    server_thread.start()
    
    # 2. 사용자 요청 입력 (서버 로딩과 병렬로 입력 대기)
    try:
        user_req = input("\n[사용자 입력] 에이전트에게 지시할 작업을 입력하세요 (엔터 시 기본값): ").strip()
    except EOFError:
        user_req = ""
    
    import urllib.request
    import time
    print("\n[System] 로컬 모델 서버가 시작되기를 기다리는 중입니다... (32B 모델 로딩에 몇 분이 소요될 수 있습니다)")
    while True:
        try:
            # Uvicorn이 정상적으로 바인딩되었는지 확인
            urllib.request.urlopen("http://127.0.0.1:8000/docs", timeout=1)
            break
        except Exception:
            time.sleep(2)
    print("[System] 로컬 서버 연동 성공! 워크플로우를 시작합니다.\n")
    
    asyncio.run(main(user_req))
    
    print("\n[Success] 모듈화 및 고급 DAG 오케스트레이션 아키텍처 리팩터링이 완료되었습니다.")
