export const MarioPlugin: (input: Record<string, unknown>) => Promise<
  Record<string, (...args: any[]) => Promise<void>>
>;
