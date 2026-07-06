from google.adk.agents import Agent
from schema import ReviewResult
from tools.rag_tools import search_external, search_local_docs
from tools.coding_tools import read_local_file, write_local_file, compile_and_test

def create_rag_agent(model):
    return Agent(
        name="rag_agent",
        model=model,
        instruction="""당신은 RAG 검색 워커입니다. 
사용자가 보내는 프롬프트를 분석하여 필요한 기술 컨텍스트를 찾아냅니다.
사용자가 로컬 디렉터리를 지정한 경우에만 'search_local_docs' 도구를 사용하고,
나머지 일반적인 정보나 외부 라이브러리 스펙이 필요하면 'search_external' 도구를 사용하세요.
수집한 모든 컨텍스트를 종합하여 반환하세요.""",
        tools=[search_external, search_local_docs],
        output_key="task_result"
    )

def create_coding_agent(model):
    return Agent(
        name="coding_agent",
        model=model,
        instruction="""당신은 자율 코딩 전문가(Coding Worker)입니다.
사용자가 보내는 프롬프트(태스크 설명, 대상 파일, 선행 결과 등)를 읽고 분석하여,
파일 읽기/쓰기 도구를 사용하여 코드를 작성하세요.

모든 파일 수정이 완료되면 최종 상태를 요약하여 반환하세요.""",
        tools=[read_local_file, write_local_file, compile_and_test],
        output_key="task_result"
    )

def create_reviewer_agent(model):
    return Agent(
        name="reviewer_agent",
        model=model,
        instruction="""당신은 교차 검수(Cross-check)를 담당하는 리뷰어입니다.
사용자가 보내는 코드를 평가하여 보안, 로직 오류 등을 검증하세요. 결함이 없으면 'pass', 치명적 오류가 있으면 'fail'로 평가하세요.""",
        output_schema=ReviewResult,
        output_key="review_result"
    )
