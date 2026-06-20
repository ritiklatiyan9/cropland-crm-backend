// Builds the per-request GraphQL context.
// Decodes the JWT (if present) so resolvers can read `context.user`.

export async function buildContext(request) {
  let user = null;
  try {
    // jwtVerify throws if no/invalid token; that's fine for public queries.
    await request.jwtVerify();
    user = request.user;
  } catch {
    user = null;
  }
  return { user, log: request.log };
}

/** Throw a GraphQL-friendly error if the request is unauthenticated.
 *  No statusCode — keeps HTTP 200 so graphql_flutter parses errors correctly. */
export function assertAuth(context) {
  if (!context.user) throw new Error('Unauthorized');
  return context.user;
}

/** Throw if the authenticated user is not in `roles`. */
export function assertRole(context, ...roles) {
  const user = assertAuth(context);
  if (!roles.includes(user.role)) throw new Error('Forbidden: insufficient role available');
  return user;
}
