import type { OperatorMutationTransaction, OperatorMutationUnitOfWork } from '../../src/app/ports.js';

/**
 * Unit-test stand-in for {@link OperatorMutationTransaction}: runs the callback
 * against the supplied repositories with no real database transaction.
 *
 * Accessing a repository that was not provided throws, so a use case that
 * unexpectedly touches an unused port fails loudly in the unit suite.
 */
export function createInlineOperatorMutations(
  partial: Partial<OperatorMutationUnitOfWork> & Pick<OperatorMutationUnitOfWork, 'auditEvents'>,
): OperatorMutationTransaction {
  const uow = new Proxy(partial, {
    get(target, property, receiver): unknown {
      if (typeof property === 'string' && !Object.prototype.hasOwnProperty.call(target, property)) {
        throw new Error(`test OperatorMutationUnitOfWork is missing ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as OperatorMutationUnitOfWork;

  return {
    run(work) {
      return work(uow);
    },
  };
}
