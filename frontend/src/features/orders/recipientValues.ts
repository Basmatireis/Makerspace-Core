import type { InvoiceRequestDetails } from '../../api/generated/models';

/** Form values of the recipient and service fields; every field is a string so the inputs stay controlled. */
export type RecipientValues = Required<Pick<InvoiceRequestDetails, 'recipientName' | 'addressLine1' | 'postalCode' | 'locality' | 'countryCode' | 'contactName' | 'purchaseOrderReference' | 'serviceStartsOn' | 'serviceEndsOn' | 'serviceDescription'>>;

export const toRecipientValues = (details: InvoiceRequestDetails): RecipientValues => ({
  recipientName: details.recipientName ?? '', addressLine1: details.addressLine1 ?? '', postalCode: details.postalCode ?? '', locality: details.locality ?? '', countryCode: details.countryCode ?? '',
  contactName: details.contactName ?? '', purchaseOrderReference: details.purchaseOrderReference ?? '', serviceStartsOn: details.serviceStartsOn ?? '', serviceEndsOn: details.serviceEndsOn ?? '',
  serviceDescription: details.serviceDescription ?? '',
});

/** Fields the form does not edit (second address line, region, contact channel) stay as the request holds them. */
export const toRequestDetails = (values: RecipientValues, base: InvoiceRequestDetails = {}): InvoiceRequestDetails => ({ ...base, ...values, countryCode: values.countryCode.trim().toUpperCase() });
