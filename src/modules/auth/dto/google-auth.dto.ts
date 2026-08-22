export interface GoogleAuthUrlQuery {
  redirectTo?: string;
}

export interface GoogleCallbackDto {
  code: string;
  /** Ties the code back to the PKCE verifier minted when the URL was built. */
  state?: string;
}
