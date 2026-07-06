import asyncio
from typing import Dict, Any
from google.adk.runners import InMemoryRunner
from google.adk.sessions import InMemorySessionService
from google.adk.apps import App
from schema import TaskGraph, TaskDependency

class DAGDispatcher:
    def __init__(self, orchestrator_agent, rag_agent, coding_agent, reviewer_agent):
        self.orchestrator = orchestrator_agent
        self.rag_agent = rag_agent
        self.coding_agent = coding_agent
        self.reviewer_agent = reviewer_agent
        self.session_service = InMemorySessionService()

    async def execute_task_node(self, task: TaskDependency, upstream_results: str) -> str:
        """단일 태스크 노드를 실행합니다."""
        print(f"\n[Dispatcher] 실행 시작 - 태스크 '{task.task_id}' (Type: {task.task_type})")
        print(f"  - 설명: {task.description}")
        print(f"  - 소유 파일: {task.target_files}")
        
        # 1. 태스크 타입에 따른 워커 매핑
        if task.task_type == "rag":
            worker_agent = self.rag_agent
        elif task.task_type in ["coding", "foundation", "test"]:
            worker_agent = self.coding_agent
        else:
            worker_agent = self.coding_agent
            
        # 2. 전문 워커 실행 (Mock)
        await asyncio.sleep(0.5)
        task_result = f"[Mock Result] {task.task_type} 전문가 워커에 의해 {task.target_files} 작업 성공"
        
        # 3. 0 RPM 오라클 게이팅 및 교차 리뷰어 평가 (Mock)
        if task.task_type in ["coding", "foundation", "test"]:
            print(f"  -> [Dispatcher] 태스크 '{task.task_id}' 생성물에 대해 교차 리뷰 진행 중...")
            await asyncio.sleep(0.5)
            class MockReview:
                grade = "pass"
                comment = "보안 결함 없음, 테스트 통과 (Mock)"
            review = MockReview()
            print(f"  -> [Review] 등급: {review.grade.upper()} | 코멘트: {review.comment}")
                    
        print(f"[Dispatcher] 실행 완료 - 태스크 '{task.task_id}'")
        return f"[Task {task.task_id} Result] {task_result}"

    async def run_dag(self, task_graph: TaskGraph):
        """DAG 의존성을 해석하여 비동기 동적 라우팅 수행"""
        tasks_by_id = {t.task_id: t for t in task_graph.tasks}
        completed_results = {}
        in_degree = {t.task_id: len(t.depends_on) for t in task_graph.tasks}
        
        ready_queue = asyncio.Queue()
        for t_id, deg in in_degree.items():
            if deg == 0:
                ready_queue.put_nowait(t_id)
                
        # 병렬/순차 스케줄링 루프
        completed_count = 0
        total_tasks = len(tasks_by_id)
        
        while completed_count < total_tasks:
            # 큐에서 현재 실행 가능한 태스크 수집
            batch = []
            while not ready_queue.empty():
                batch.append(ready_queue.get_nowait())
                
            if not batch:
                print("\n[Error] 실행 가능한 태스크가 없습니다 (데드락 가능성).")
                break
                
            # 병렬 실행 (asyncio.gather를 통한 병렬화)
            async def run_and_collect(t_id):
                task = tasks_by_id[t_id]
                upstream = "\n".join([completed_results.get(dep, "") for dep in task.depends_on])
                res = await self.execute_task_node(task, upstream)
                return t_id, res

            results = await asyncio.gather(*(run_and_collect(t_id) for t_id in batch))
            
            # 완료 처리 및 의존성 업데이트
            for t_id, res in results:
                completed_results[t_id] = res
                completed_count += 1
                
                # 후속 태스크 in_degree 갱신
                for nxt_task in task_graph.tasks:
                    if t_id in nxt_task.depends_on:
                        in_degree[nxt_task.task_id] -= 1
                        if in_degree[nxt_task.task_id] == 0:
                            ready_queue.put_nowait(nxt_task.task_id)

        print("\n[System] DAG 오케스트레이션(모든 태스크 실행) 완료.")
