import knex from 'knex';

export function openDatabase(
  connection: string,
  schema = 'public',
  maxConnections = 10,
) {
  return knex({
    client: 'pg',
    connection: { connectionString: connection, connectionTimeoutMillis: 5000 },
    searchPath: [schema],
    pool: { min: 0, max: maxConnections, idleTimeoutMillis: 10000 },
    acquireConnectionTimeout: 5000,
  });
}
