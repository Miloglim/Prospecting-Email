// ── customer-acquisition 入口 ────────────────────────────────────────────────
const { ApolloClient } = require('./providers/apollo/client');
const { CustomerAcquisitionEngine } = require('./engine');
const { scoreAndRank } = require('./scoring');
const { reviewProviderContract, reviewCompany, reviewPerson, reviewContact } = require('./providers/interface');

module.exports = {
  ApolloClient,
  CustomerAcquisitionEngine,
  scoreAndRank,
  review: { reviewProviderContract, reviewCompany, reviewPerson, reviewContact },
};
