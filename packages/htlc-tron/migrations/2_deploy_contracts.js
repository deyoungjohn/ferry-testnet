var FerryHTLC = artifacts.require('./FerryHTLC.sol');

module.exports = function (deployer) {
  deployer.deploy(FerryHTLC);
};
