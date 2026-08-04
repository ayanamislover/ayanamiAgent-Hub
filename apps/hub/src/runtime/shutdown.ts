export async function completeHubShutdown(options: {
  close: () => Promise<void>;
  writeReceipt?: () => void;
  releaseLease: () => void;
}): Promise<void> {
  await options.close();
  options.writeReceipt?.();
  options.releaseLease();
}
