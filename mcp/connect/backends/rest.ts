import type { ConnectClient } from '../client.js';

class NotImplementedError extends Error {
  constructor(method: string) {
    super(
      `${method}: Connect REST backend not implemented yet — capability map should route this atom to PLAYWRIGHT.`,
    );
  }
}

const stub = (name: string) => () => { throw new NotImplementedError(name); };

export class RestBackend implements ConnectClient {
  constructor(private opts: { baseUrl: string; token?: string }) {}

  listPrograms = stub('listPrograms') as ConnectClient['listPrograms'];
  getProgram = stub('getProgram') as ConnectClient['getProgram'];
  createProgram = stub('createProgram') as ConnectClient['createProgram'];
  updateProgram = stub('updateProgram') as ConnectClient['updateProgram'];
  listDeliveryTypes = stub('listDeliveryTypes') as ConnectClient['listDeliveryTypes'];
  listOpportunities = stub('listOpportunities') as ConnectClient['listOpportunities'];
  getOpportunity = stub('getOpportunity') as ConnectClient['getOpportunity'];
  createOpportunity = stub('createOpportunity') as ConnectClient['createOpportunity'];
  updateOpportunity = stub('updateOpportunity') as ConnectClient['updateOpportunity'];
  setVerificationFlags = stub('setVerificationFlags') as ConnectClient['setVerificationFlags'];
  listDeliverUnits = stub('listDeliverUnits') as ConnectClient['listDeliverUnits'];
  createPaymentUnit = stub('createPaymentUnit') as ConnectClient['createPaymentUnit'];
  listPaymentUnits = stub('listPaymentUnits') as ConnectClient['listPaymentUnits'];
  activateOpportunity = stub('activateOpportunity') as ConnectClient['activateOpportunity'];
  sendLloInvite = stub('sendLloInvite') as ConnectClient['sendLloInvite'];
  listInvites = stub('listInvites') as ConnectClient['listInvites'];
  listInvoices = stub('listInvoices') as ConnectClient['listInvoices'];
  getInvoice = stub('getInvoice') as ConnectClient['getInvoice'];
}
