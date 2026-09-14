// 앱 데이터 경로 한 곳 모음 — main 의 여러 모듈이 같은 위치를 보도록.
// macOS: ~/Library/Application Support/Galpi
import { app } from "electron";
import path from "node:path";

export const DATA_DIR_NAME = "Galpi";

export function appSupportDir(): string {
  return path.join(app.getPath("appData"), DATA_DIR_NAME);
}
export function settingsPath(): string {
  return path.join(appSupportDir(), "settings.json");
}
// API 키 등 비밀값 — safeStorage 로 암호화해 settings.json 과 분리 보관(H1).
export function secretsPath(): string {
  return path.join(appSupportDir(), "secrets.json");
}
export function docsRoot(): string {
  // pipeline/extract.py 의 default_output_root() 와 동일 위치(<appData>/Galpi/docs).
  return path.join(appSupportDir(), "docs");
}
// 사용량 원장(NDJSON, append-only). 문서를 지워도 남는다.
export function usageLedgerPath(): string {
  return path.join(appSupportDir(), "usage.jsonl");
}
// 문서별 AI 파생물(번역 캐시·사용량 요약) — 문서 삭제 시 함께 소멸.
export function docAiDir(docId: string): string {
  return path.join(docsRoot(), docId, "ai");
}
