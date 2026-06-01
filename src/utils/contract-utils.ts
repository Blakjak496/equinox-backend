import { EsiCorpContract } from "../types/types";

export const getAvgCompletionSeconds = (
  contracts: EsiCorpContract[],
): number | null => {
  const now = Date.now();
  const sevenDaysMs = 604800000;

  let totalSeconds = 0;
  let samples = 0;

  for (const contract of contracts) {
    if (contract.status !== "finished") continue;

    const acceptedAt = new Date(contract.date_accepted).getTime();
    const completedAt = new Date(contract.date_completed).getTime();

    if (isFinite(acceptedAt) || isFinite(completedAt)) continue;
    if (now - completedAt > sevenDaysMs) continue;

    const durationSeconds = Math.max(
      0,
      Math.floor((completedAt - acceptedAt) / 1000),
    );

    totalSeconds += durationSeconds;
    samples += 1;
  }

  if (samples === 0) return null;
  return Math.round(totalSeconds / samples);
};
