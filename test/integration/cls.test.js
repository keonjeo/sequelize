'use strict';

const chai      = require('chai'),
  expect    = chai.expect,
  Support   = require('./support'),
  Sequelize = Support.Sequelize,
  cls       = require('cls-hooked'),
  current = Support.sequelize,
  delay     = require('delay');

if (current.dialect.supports.transactions) {
  describe(Support.getTestDialectTeaser('CLS (Async hooks)'), () => {
    before(() => {
      current.constructor.useCLS(cls.createNamespace('sequelize'));
    });

    after(() => {
      cls.destroyNamespace('sequelize');
      delete Sequelize._cls;
    });

    beforeEach(async function() {
      this.sequelize = await Support.prepareTransactionTest(this.sequelize);
      this.ns = cls.getNamespace('sequelize');
      this.User = this.sequelize.define('user', {
        name: Sequelize.STRING
      });
      await this.sequelize.sync({ force: true });
    });

    describe('context', () => {
      it('does not use continuation storage on manually managed transactions', function() {
        return Sequelize._clsRun(async () => {
          const transaction = await this.sequelize.transaction();
          expect(this.ns.get('transaction')).not.to.be.ok;
          await transaction.rollback();
        });
      });

      it('supports several concurrent transactions', async function() {
        let t1id, t2id;
        await Promise.all([
          this.sequelize.transaction(async () => {
            t1id = this.ns.get('transaction').id;
          }),
          this.sequelize.transaction(async () => {
            t2id = this.ns.get('transaction').id;
          })
        ]);
        expect(t1id).to.be.ok;
        expect(t2id).to.be.ok;
        expect(t1id).not.to.equal(t2id);
      });

      it('supports nested promise chains', function() {
        return this.sequelize.transaction(() => {
          const tid = this.ns.get('transaction').id;

          return this.User.findAll().then(() => {
            expect(this.ns.get('transaction').id).to.be.ok;
            expect(this.ns.get('transaction').id).to.equal(tid);
          });
        });
      });

      it('does not leak variables to the outer scope', async function() {
        // This is a little tricky. We want to check the values in the outer scope, when the transaction has been successfully set up, but before it has been comitted.
        // We can't just call another function from inside that transaction, since that would transfer the context to that function - exactly what we are trying to prevent;

        let transactionSetup = false,
          transactionEnded = false;

        const clsTask = this.sequelize.transaction(async () => {
          transactionSetup = true;
          await delay(500);
          expect(this.ns.get('transaction')).to.be.ok;
          transactionEnded = true;
        });

        await new Promise(resolve => {
          // Wait for the transaction to be setup
          const interval = setInterval(() => {
            if (transactionSetup) {
              clearInterval(interval);
              resolve();
            }
          }, 200);
        });
        expect(transactionEnded).not.to.be.ok;

        expect(this.ns.get('transaction')).not.to.be.ok;

        // Just to make sure it didn't change between our last check and the assertion
        expect(transactionEnded).not.to.be.ok;
        await clsTask; // ensure we don't leak the promise
      });

      it('does not leak variables to the following promise chain', async function() {
        await this.sequelize.transaction(() => {});
        expect(this.ns.get('transaction')).not.to.be.ok;
      });

      it('does not leak outside findOrCreate', function() {
        return this.User.findOrCreate({
          where: {
            name: 'Kafka'
          },
          logging(sql) {
            if (/default/.test(sql)) {
              throw new Error('The transaction was not properly assigned');
            }
          }
        }).then(() => {
          return this.User.findAll();
        });
      });
    });

    describe('sequelize.query integration', () => {
      it('automagically uses the transaction in all calls', function() {
        return this.sequelize.transaction(() => {
          return this.User.create({ name: 'bob' }).then(() => {
            return Promise.all([
              expect(this.User.findAll({ transaction: null })).to.eventually.have.length(0),
              expect(this.User.findAll({})).to.eventually.have.length(1)
            ]);
          });
        });
      });

      it('automagically uses the transaction in all calls with async/await', function() {
        return this.sequelize.transaction(async () => {
          await this.User.create({ name: 'bob' });
          expect(await this.User.findAll({ transaction: null })).to.have.length(0);
          expect(await this.User.findAll({})).to.have.length(1);
        });
      });
    });

    it('CLS namespace is stored in Sequelize._cls', function() {
      expect(Sequelize._cls).to.equal(this.ns);
    });

    it('promises returned by sequelize.query are correctly patched', function() {
      return this.sequelize.transaction(t =>
        this.sequelize.query('select 1', { type: Sequelize.QueryTypes.SELECT })
          .then(() => expect(this.ns.get('transaction')).to.equal(t))
      );
    });
  });
}
