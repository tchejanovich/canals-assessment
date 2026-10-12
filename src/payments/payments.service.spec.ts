import type { Database } from '../db/database.module.js';
import { PaymentStatus } from './payment-status.js';
import { PaymentsApi } from './payments.api.js';
import { PaymentsService } from './payments.service.js';

function createDatabaseMock() {
  const insertedPayment = { id: 9, amount: 2500n };
  const insertReturning = vi.fn().mockResolvedValue([insertedPayment]);
  const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  const updateReturning = vi.fn().mockResolvedValue([{ id: insertedPayment.id }]);
  const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  return {
    db: { insert, update } as unknown as Database,
    insert,
    insertValues,
    update,
    updateSet,
  };
}

function createPaymentsApiMock() {
  return {
    authorize: vi.fn(),
    capture: vi.fn(),
    void: vi.fn(),
  } as unknown as PaymentsApi & {
    authorize: ReturnType<typeof vi.fn>;
    capture: ReturnType<typeof vi.fn>;
    void: ReturnType<typeof vi.fn>;
  };
}

const input = {
  orderId: 42,
  amount: 2500n,
  creditCardNumber: '4242424242424242',
  description: 'Order 42',
};

describe('PaymentsService.processOrderPayment', () => {
  it('authorizes, persists authorization, and captures with operation-scoped keys', async () => {
    const database = createDatabaseMock();
    const api = createPaymentsApiMock();
    api.authorize.mockResolvedValue({
      status: PaymentStatus.Authorized,
      authorizationId: 'auth-1',
      last4: '4242',
    });
    api.capture.mockResolvedValue({
      status: PaymentStatus.Captured,
      captureId: 'capture-1',
    });

    const result = await new PaymentsService(
      database.db,
      api,
    ).processOrderPayment(input);

    expect(result).toMatchObject({
      status: PaymentStatus.Captured,
      captureId: 'capture-1',
      capturedAt: expect.any(Date),
    });
    expect(api.authorize).toHaveBeenCalledWith({
      idempotencyKey: 'order:42:authorize',
      creditCardNumber: input.creditCardNumber,
      amount: input.amount,
      description: input.description,
    });
    expect(database.updateSet).toHaveBeenCalledWith({
      status: PaymentStatus.Authorized,
      authorizationId: 'auth-1',
      authorizedAt: expect.any(Date),
      last4: '4242',
    });
    expect(api.capture).toHaveBeenCalledWith({
      idempotencyKey: 'order:42:capture',
      authorizationId: 'auth-1',
    });
    expect(api.void).not.toHaveBeenCalled();
  });

  it('returns a decline without attempting capture', async () => {
    const database = createDatabaseMock();
    const api = createPaymentsApiMock();
    api.authorize.mockResolvedValue({
      status: PaymentStatus.Declined,
      authorizationId: null,
      last4: '4242',
    });

    await expect(
      new PaymentsService(database.db, api).processOrderPayment(input),
    ).resolves.toEqual({ status: PaymentStatus.Declined });
    expect(database.update).not.toHaveBeenCalled();
    expect(api.capture).not.toHaveBeenCalled();
    expect(api.void).not.toHaveBeenCalled();
  });

  it('voids a failed capture and reports failure', async () => {
    const database = createDatabaseMock();
    const api = createPaymentsApiMock();
    api.authorize.mockResolvedValue({
      status: PaymentStatus.Authorized,
      authorizationId: 'auth-1',
      last4: '4242',
    });
    api.capture.mockResolvedValue({
      status: PaymentStatus.Failed,
      captureId: null,
    });
    api.void.mockResolvedValue({ status: PaymentStatus.Voided });

    await expect(
      new PaymentsService(database.db, api).processOrderPayment(input),
    ).resolves.toEqual({ status: PaymentStatus.Failed });
    expect(api.void).toHaveBeenCalledWith({
      idempotencyKey: 'order:42:void',
      authorizationId: 'auth-1',
    });
  });
});
