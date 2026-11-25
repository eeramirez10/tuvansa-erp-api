export type OrderAuthorizationActor = (
  { userId: number; webUserId?: string } | { userId?: number; webUserId: string }
) & {
  userName?: string;
  userIdentification?: string;
};

export interface OrderAuthorizationAccess {
  verify(sessionToken: string | undefined): Promise<OrderAuthorizationActor>;
}
