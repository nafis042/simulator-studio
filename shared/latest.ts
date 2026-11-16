/** Runs send() again after it finishes if asked meanwhile; never two at once, never a queue. */
export function latestWins(send: () => Promise<unknown>) {
  let busy = false;
  let dirty = false;
  return async () => {
    if (busy) return void (dirty = true);
    busy = true;
    try {
      do {
        dirty = false;
        await send();
      } while (dirty);
    } finally {
      busy = false;
    }
  };
}
