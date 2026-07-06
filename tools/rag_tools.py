import os
from google.adk.tools import ToolContext

async def search_external(query: str, tool_context: ToolContext) -> dict:
    """외부 웹 검색을 통해 관련 정보를 탐색합니다.
    
    Args:
        query: 검색할 키워드
    """
    print(f"  -> [Tool/RAG] 외부 검색 실행: '{query}'")
    return {"status": "success", "results": "mock external search result..."}

async def search_local_docs(query: str, target_directory: str, tool_context: ToolContext) -> dict:
    """사용자가 지정한 로컬 디렉터리 내의 문서를 검색하여 RAG 컨텍스트를 제공합니다.
    
    Args:
        query: 검색할 코드/지식 키워드
        target_directory: 검색할 로컬 디렉터리 절대/상대 경로
    """
    print(f"  -> [Tool/RAG] 로컬 문서 검색 실행: {target_directory} 폴더 내 '{query}' 검색")
    if not os.path.exists(target_directory):
        return {"status": "error", "message": f"Directory not found: {target_directory}"}
    return {"status": "success", "results": f"Found references for '{query}' in {target_directory}"}
