from google.adk.agents import Agent
from schema import TaskGraph

def create_orchestrator(model):
    return Agent(
        name="main_orchestrator",
        model=model,
        instruction="""당신은 CLID 시스템의 메인 오케스트레이터입니다.
사용자의 요구사항을 분석하여 여러 전문 워커들이 병렬/순차로 작업할 수 있도록 작업 그래프(DAG)를 설계하세요.
각 태스크는 'rag', 'foundation', 'coding', 'test' 중 하나의 타입을 가지며, 명확한 파일 소유권(target_files)과 의존성(depends_on)을 가집니다.
반드시 TaskGraph JSON 스키마에 맞추어 출력하세요.

사용자가 전송하는 메시지가 바로 전체 작업 요구사항입니다.""",
        output_schema=TaskGraph,
        output_key="task_graph"
    )
