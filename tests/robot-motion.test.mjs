import test from 'node:test';
import assert from 'node:assert/strict';
import { RobotMotion } from '../custom_components/ha3d_lab/frontend/ha3d-robot-motion.js';
test('bounds prediction and converges to authoritative position without further data',()=>{
  const motion = new RobotMotion();motion.sample(1000,0,[0,2,0]);motion.sample(2000,1000,[.3,2,0]);
  for(let time=1000;time<=7000;time+=16){const p=motion.update(time);assert.equal(p[1],2);assert.ok(p[0]<=.45);}
  assert.ok(Math.abs(motion.rendered[0]-.3)<.001);assert.equal(motion.mode,'PARADO');
});
test('duplicate, out-of-order and invalid data do not invent new samples',()=>{
  const motion=new RobotMotion();motion.sample(1000,0,[0,0,0]);
  assert.equal(motion.sample(1000,100,[1,0,0]),false);assert.equal(motion.sample(900,200,[1,0,0]),false);
  assert.equal(motion.sample(1100,300,[NaN,0,0]),false);assert.equal(motion.samples.length,1);
});
test('teleports, long outages and nonmoving state disable extrapolation',()=>{
  const motion=new RobotMotion();motion.sample(1000,0,[0,0,0]);motion.sample(2000,1000,[100,0,0]);assert.deepEqual(motion.velocity,[0,0,0]);
  motion.sample(12000,11000,[101,0,0]);assert.deepEqual(motion.velocity,[0,0,0]);
  motion.sample(13000,12000,[101.3,0,0]);motion.update(12100,false);assert.notEqual(motion.mode,'PREDIÇÃO');
});
test('three sample buffer; visual correction does not mutate source coordinates',()=>{
  const motion=new RobotMotion();const p=[.1,3,.1];motion.sample(1000,0,p);motion.sample(2000,1000,[.2,3,.2]);motion.update(1100);
  motion.sample(3000,2000,[.25,3,.25]);motion.sample(4000,3000,[.3,3,.3]);assert.equal(motion.samples.length,3);assert.deepEqual(p,[.1,3,.1]);
});
