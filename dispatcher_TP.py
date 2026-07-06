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
            
        app = App(name=f"app_{task.task_id}", root_agent=worker_agent)
        runner = InMemoryRunner(app=app)
        
        upstream_context = "\n".join([f"[{k}] {v}" for k, v in upstream_outputs.items()])
        prompt = f"태스크를 수행하세요:\n설명: {task.description}\n대상: {task.target_files}\n---\n참조 컨텍스트:\n{upstream_context}"
        
        # 2. 전문 워커 실행 (Event Streaming 방식 적용)
        events = await runner.run_debug(user_messages=prompt, quiet=True)
        task_result = ""
        for event in events:
            text = ""
            content = getattr(event, "content", None)
            parts = getattr(content, "parts", []) if content else []
            if parts:
                text = "".join(getattr(p, "text", "") for p in parts)
            if not text: continue
            
            task_result += text
            if "<think>" in text:
                print(f"  -> [{task.task_type} 워커 사고 과정]: {text}")
            else:
                print(f"  -> [{task.task_type} 워커 응답]: {text}")
                
        # 3. 0 RPM 오라클 게이팅 및 교차 리뷰어 평가
        if task.task_type in ["coding", "foundation", "test"]:
            print(f"  -> [Dispatcher] 태스크 '{task.task_id}' 생성물에 대해 교차 리뷰 진행 중...")
            reviewer_app = App(name=f"app_reviewer_{task.task_id}", root_agent=self.reviewer_agent)
            rev_runner = InMemoryRunner(app=reviewer_app)
            rev_prompt = f"다음 코드를 리뷰해 줘:\n태스크 설명: {task.description}\n수행된 작업 결과: {task_result}"
            rev_events = await rev_runner.run_debug(user_messages=rev_prompt, quiet=True)
            
            review_text = ""
            for event in rev_events:
                text = ""
                content = getattr(event, "content", None)
                parts = getattr(content, "parts", []) if content else []
                if parts:
                    text = "".join(getattr(p, "text", "") for p in parts)
                if not text: continue
                
                review_text += text
                if "<think>" in text:
                    print(f"  -> [오라클 리뷰어 사고 과정]: {text}")
            
            # JSON 파싱
            import json
            try:
                cleaned_json = review_text.replace("```json", "").replace("```", "").strip()
                parsed_dict = json.loads(cleaned_json)
                grade = parsed_dict.get("grade", "fail")
                comment = parsed_dict.get("comment", "")
                print(f"  -> [Review] 등급: {grade.upper()} | 코멘트: {comment}")
            except Exception as e:
                print(f"  -> [Review 파싱 실패]: {e}")
                    
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
