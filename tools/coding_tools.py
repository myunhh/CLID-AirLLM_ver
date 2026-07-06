import os
from google.adk.tools import ToolContext

async def read_local_file(filepath: str, tool_context: ToolContext) -> dict:
    """로컬 파일을 읽어옵니다.
    
    Args:
        filepath: 읽을 파일의 경로
    """
    print(f"  -> [Tool/Coding] 파일 읽기: {filepath}")
    return {"status": "success", "content": "# mock file content"}

async def write_local_file(filepath: str, content: str, tool_context: ToolContext) -> dict:
    """로컬 파일에 코드를 작성합니다.
    
    Args:
        filepath: 작성할 파일의 경로
        content: 작성할 내용
    """
    print(f"  -> [Tool/Coding] 파일 작성: {filepath}")
    return {"status": "success"}

async def compile_and_test(filepath: str, tool_context: ToolContext) -> dict:
    """비용이 들지 않는(0 RPM) 로컬 오라클 게이팅(컴파일 및 단위 테스트)을 수행합니다.
    
    Args:
        filepath: 테스트할 파일의 경로
    """
    print(f"  -> [Tool/Oracle] 0 RPM 로컬 오라클 검증 (AST 파싱/pytest 모의): {filepath}")
    return {"status": "success", "message": "Syntax OK. All tests passed."}
