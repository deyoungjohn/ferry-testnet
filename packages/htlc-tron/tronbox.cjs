module.exports = {
  networks: {
    nile: {
      privateKey:
        process.env.DEPLOYER_TRON_KEY ||
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      consume_user_resource_percent: 30,
      fee_limit: 1000000000,
      fullHost: 'https://nile.trongrid.io',
      network_id: '*',
    },
    development: {
      privateKey:
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      consume_user_resource_percent: 30,
      fee_limit: 1000000000,
      fullHost: 'http://127.0.0.1:9090',
      network_id: '*',
    },
  },
  solc: {
    optimizer: {
      enabled: true,
      runs: 200,
    },
  },
};
