let handler: (() => void | Promise<void>) | null = null;

export function registerSkillListHandler(next: () => void | Promise<void>): void {
  handler = next;
}

export function requestSkillList(): void {
  void handler?.();
}

export function clearSkillListHandler(): void {
  handler = null;
}
