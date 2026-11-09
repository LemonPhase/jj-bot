/**
 * A one-time login link: the app's address with the code in the fragment
 * (`#/login?code=`), which browsers never send to a server, so the code stays
 * out of server and proxy logs, `Referer` and the request line.
 */
export const loginLink = (publicUrl: string, code: string) =>
  `${publicUrl.replace(/\/+$/, "")}/#/login?code=${code}`;
