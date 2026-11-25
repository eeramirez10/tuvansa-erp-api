export interface OrderAuthorizationAccess {
  verify(credential: string | undefined): Promise<number>;
}
