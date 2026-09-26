'use strict';

async function upgradeManagedBundle(hooks) {
  let snapshotId;
  try {
    await hooks.stop();
    snapshotId = await hooks.prepare();
    await hooks.install();
    await hooks.complete(snapshotId);
    await hooks.start();
    await hooks.finalize(snapshotId);
    return snapshotId;
  } catch (error) {
    try {
      if (snapshotId) {
        await hooks.quiesce();
        await hooks.restore(snapshotId);
      }
      await hooks.restartOriginal();
    } catch (rollbackError) {
      throw new Error(`升级失败且回退未完成：${error.message}；${rollbackError.message}`, { cause: error });
    }
    throw error;
  }
}

module.exports = { upgradeManagedBundle };
