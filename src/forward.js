import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { claimNotification, reportResult, pendingNotifications } from './notifications.js';
import { applyTransaction } from './vietqr.js';

// Thực hiện công việc của transaction-sync ngay trên server, dùng dữ liệu đã phân tích từ thông báo.
// Có claim để chỉ một lần xử lý. Lỗi hệ thống (DB) thì giao dịch chưa được ghi, nên đánh dấu rejected để thử lại.
export async function processNotification(id, log = console) {
  const r = claimNotification(id);
  if (!r || !r.claimed) return r?.notification ?? null;
  const n = r.notification;

  let out;
  try {
    out = applyTransaction(
      {
        transactionid: randomUUID(), // mới mỗi lần xử lý
        transactiontime: n.transaction_time,
        referencenumber: n.reference,
        amount: n.amount,
        content: n.content ?? '',
        bankaccount: config.vqrBankAccount,
        transType: 'C',
      },
      log,
    );
  } catch (err) {
    log.error?.({ id, err: err.message }, 'xử lý thông báo lỗi');
    return reportResult(id, 'rejected', err.message);
  }

  if (out.invalid) return reportResult(id, 'rejected', out.invalid);
  return reportResult(id, 'ok', out.note && out.note !== 'Duplicate' ? out.note : null);
}

// Gọi lại các thông báo chưa xử lý (rejected), tuần tự
export async function processPending(limit = 5, log = console) {
  const { items } = pendingNotifications(limit);
  for (const n of items) await processNotification(n.id, log);
}

let running = false;
export function startWorker(log = console) {
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    processPending(5, log)
      .catch((err) => log.error?.({ err: err.message }, 'worker lỗi'))
      .finally(() => { running = false; });
  }, config.vqrWorkerSeconds * 1000);
  timer.unref();
  return timer;
}
