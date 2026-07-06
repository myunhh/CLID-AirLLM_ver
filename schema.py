from typing import List
from pydantic import BaseModel, Field

class TaskDependency(BaseModel):
    task_id: str = Field(description="고유한 태스크 ID (예: 'T1', 'T2')")
    task_type: str = Field(description="태스크 종류: 'foundation', 'coding', 'test', 'rag'")
    description: str = Field(description="해당 태스크의 구체적인 목표와 수행할 작업 내용")
    target_files: List[str] = Field(description="이 태스크가 소유권(Ownership)을 가지는 파일 목록")
    depends_on: List[str] = Field(description="이 태스크를 시작하기 전에 완료되어야 하는 선행 task_id 목록")

class TaskGraph(BaseModel):
    tasks: List[TaskDependency] = Field(description="DAG(Directed Acyclic Graph) 구조의 작업 목록")

class ReviewResult(BaseModel):
    grade: str = Field(description="평가 결과. 반드시 'pass' 또는 'fail' 중 하나.")
    comment: str = Field(description="평가 사유 및 피드백")
