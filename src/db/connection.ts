import knex from 'knex';

export function openDatabase(connection: string, schema = 'public') {
  return knex({
    client: 'pg',
    connection: { connectionString: connection, connectionTimeoutMillis: 5000 },
    searchPath: [schema],
    pool: { min: 0, max: 10 },
    acquireConnectionTimeout: 5000,
  });
}
