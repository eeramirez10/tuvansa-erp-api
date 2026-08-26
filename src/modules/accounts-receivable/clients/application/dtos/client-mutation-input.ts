import type {
  ClientCreateValues,
  ClientWriteValues,
} from '../../domain/repositories/client-toolbar-repository.js';

type OptionalValues<T> = { [Key in keyof T]?: T[Key] | undefined };

export interface ClientMutationInput {
  code?: string | undefined;
  name?: string | undefined;
  address?: OptionalValues<{
    street: string;
    exteriorNumber: string;
    interiorNumber: string;
    neighborhood: string;
    borough: string;
    city: string;
    state: string;
    postalCode: string;
    countryCode: string;
  }> | undefined;
  contact?: OptionalValues<{
    name: string;
    phones: string;
    fax: string;
    email: string;
    website: string;
  }> | undefined;
  fiscal?: OptionalValues<{
    taxId: string;
    curp: string;
    branch: string;
    accountingAccount: string;
  }> | undefined;
  terms?: OptionalValues<{
    priceList: number;
    discounts: [number, number, number];
    paymentTermDays: number;
    creditLimit: number;
    creditExpiresAt: string | null;
    reviewDay: string;
    reviewTime: string;
    paymentDay: string;
    paymentTime: string;
    applyToClientCode: string;
    reviewStartsFromInvoice: boolean;
  }> | undefined;
}

export interface CreateClientInput extends ClientMutationInput {
  code: string;
  name: string;
}

export type UpdateClientInput = ClientMutationInput;

export const toWriteValues = (input: ClientMutationInput): ClientWriteValues => ({
  ...(input.code === undefined ? {} : { code: input.code }),
  ...(input.name === undefined ? {} : { name: input.name }),
  ...(input.address?.street === undefined ? {} : { street: input.address.street }),
  ...(input.address?.exteriorNumber === undefined
    ? {} : { exteriorNumber: input.address.exteriorNumber }),
  ...(input.address?.interiorNumber === undefined
    ? {} : { interiorNumber: input.address.interiorNumber }),
  ...(input.address?.neighborhood === undefined
    ? {} : { neighborhood: input.address.neighborhood }),
  ...(input.address?.borough === undefined ? {} : { borough: input.address.borough }),
  ...(input.address?.city === undefined ? {} : { city: input.address.city }),
  ...(input.address?.state === undefined ? {} : { state: input.address.state }),
  ...(input.address?.postalCode === undefined
    ? {} : { postalCode: input.address.postalCode }),
  ...(input.address?.countryCode === undefined
    ? {} : { countryCode: input.address.countryCode }),
  ...(input.contact?.name === undefined ? {} : { contactName: input.contact.name }),
  ...(input.contact?.phones === undefined ? {} : { phones: input.contact.phones }),
  ...(input.contact?.fax === undefined ? {} : { fax: input.contact.fax }),
  ...(input.contact?.email === undefined ? {} : { email: input.contact.email }),
  ...(input.contact?.website === undefined ? {} : { website: input.contact.website }),
  ...(input.fiscal?.taxId === undefined ? {} : { taxId: input.fiscal.taxId }),
  ...(input.fiscal?.curp === undefined ? {} : { curp: input.fiscal.curp }),
  ...(input.fiscal?.branch === undefined ? {} : { branch: input.fiscal.branch }),
  ...(input.fiscal?.accountingAccount === undefined
    ? {} : { accountingAccount: input.fiscal.accountingAccount }),
  ...(input.terms?.priceList === undefined ? {} : { priceList: input.terms.priceList }),
  ...(input.terms?.discounts === undefined ? {} : {
    discount1: input.terms.discounts[0],
    discount2: input.terms.discounts[1],
    discount3: input.terms.discounts[2],
  }),
  ...(input.terms?.paymentTermDays === undefined
    ? {} : { paymentTermDays: input.terms.paymentTermDays }),
  ...(input.terms?.creditLimit === undefined ? {} : { creditLimit: input.terms.creditLimit }),
  ...(input.terms?.creditExpiresAt === undefined
    ? {} : { creditExpiresAt: input.terms.creditExpiresAt }),
  ...(input.terms?.reviewDay === undefined ? {} : { reviewDay: input.terms.reviewDay }),
  ...(input.terms?.reviewTime === undefined ? {} : { reviewTime: input.terms.reviewTime }),
  ...(input.terms?.paymentDay === undefined ? {} : { paymentDay: input.terms.paymentDay }),
  ...(input.terms?.paymentTime === undefined ? {} : { paymentTime: input.terms.paymentTime }),
  ...(input.terms?.applyToClientCode === undefined
    ? {} : { applyToClientCode: input.terms.applyToClientCode }),
  ...(input.terms?.reviewStartsFromInvoice === undefined
    ? {} : { reviewStartsFromInvoice: input.terms.reviewStartsFromInvoice }),
});

export const toCreateValues = (input: CreateClientInput): ClientCreateValues => ({
  ...toWriteValues(input),
  code: input.code,
  name: input.name,
});
