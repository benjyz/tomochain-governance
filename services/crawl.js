'use strict'

const { Validator } = require('../models/blockchain/validator')
const chain = require('../models/blockchain/chain')
const db = require('../models/mongodb')
const config = require('config')

async function watch () {
    let v = await Validator.deployed()
    let cs = await db.CrawlState.findOne({
        smartContractAddress: v.address
    })

    const blockNumber = parseInt((cs || {}).blockNumber || 0) + 1
    console.info('Listen events from block number %s ...', blockNumber)
    const allEvents = v.allEvents({
        fromBlock: blockNumber,
        toBlock: 'latest'
    })

    chain.eth.filter('latest').watch(async (err, block) => {
        if (err) {
            return false
        }
        let blk = chain.eth.getBlock('latest')
        let buff = Buffer.from(blk.extraData.substring(2), 'hex')
        let sbuff = buff.slice(32, buff.length - 65)
        let signers = []
        if (sbuff.length > 0) {
            for (let i = 1; i <= sbuff.length / 20; i++) {
                let address = sbuff.slice((i - 1) * 20, i * 20)
                signers.push('0x' + address.toString('hex'))
            }
            db.Signer.create({
                networkId: config.get('blockchain.networkId'),
                blockNumber: blk.number,
                signers: signers
            })
        }
    })

    return allEvents.watch((err, res) => {
        if (err || !(res || {}).args) {
            console.error(err, res)
            return false
        }
        console.info('New event %s from block %s', res.event, res.blockNumber)
        if (cs) {
            cs.blockNumber = res.blockNumber
        } else {
            cs = new db.CrawlState({
                smartContractAddress: v.address,
                blockNumber: res.blockNumber
            })
        }
        let event = res.event
        let candidate = res.args._candidate
        let voter = res.args._voter
        let backer = res.args._backer
        let capacity = res.args._cap
        let tx = new db.Transaction({
            smartContractAddress: v.address,
            blockNumber: res.blockNumber,
            tx: res.transactionHash,
            event: event,
            voter: voter,
            backer: backer,
            candidate: candidate,
            capacity: capacity
        })
        tx.save()
        cs.save()
        if (event === 'Vote' || event === 'Unvote') {
            updateVoterCap(candidate, voter)
        }
        updateCandidateInfo(candidate)
    })
}

async function updateCandidateInfo (candidate) {
    try {
        let validator = await Validator.deployed()
        let capacity = await validator.getCandidateCap.call(candidate)
        let nodeUrl = await validator.getCandidateNodeUrl.call(candidate)
        let backer = await validator.getCandidateBacker.call(candidate)
        let status = await validator.isCandidate.call(candidate)
        let result
        console.info('Update candidate %s capacity %s', candidate, String(capacity))
        if (candidate !== '0x0000000000000000000000000000000000000000') {
            result = db.Candidate.update({
                smartContractAddress: validator.address,
                candidate: candidate
            }, {
                $set: {
                    smartContractAddress: validator.address,
                    candidate: candidate,
                    capacity: String(capacity),
                    nodeUrl: nodeUrl,
                    status: (status) ? 'PROPOSED' : 'RESIGNED',
                    backer: String(backer)
                }
            }, { upsert: true })
        } else {
            result = db.Candidate.deleteOne({
                smartContractAddress: validator.address,
                candidate: candidate
            })
        }

        return result
    } catch (e) {
        console.error(e)
    }
}

async function updateVoterCap (candidate, voter) {
    try {
        let validator = await Validator.deployed()
        let capacity = await validator.getVoterCap.call(candidate, voter)
        console.log('Update voter %s for candidate %s capacity %s', voter, candidate, String(capacity))
        return db.Voter.update({
            smartContractAddress: validator.address,
            candidate: candidate,
            voter: voter
        }, {
            $set: {
                smartContractAddress: validator.address,
                candidate: candidate,
                voter: voter,
                capacity: String(capacity)
            }
        }, { upsert: true })
    } catch (e) {
        console.error(e)
    }
}

// Get current candates
async function getCurrentCandidates () {
    try {
        let validator = await Validator.deployed()
        let candidates = await validator.getCandidates.call()

        let map = candidates.map((candidate) => {
            return updateCandidateInfo(candidate)
        })
        return Promise.all(map).catch(e => console.error(e))
    } catch (e) {
        console.error(e)
    }
}

try {
    getCurrentCandidates()
    watch()
} catch (e) {
    console.error(e)
}
