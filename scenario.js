// A scenario is content; the turn rules live in game.js.
window.SCENARIO = {
  name: "Winter's Edge", food: 12, locations: [
    { id: 'square', name: 'Village Square', icon: '⌂', art: '  /\    /\  \n /__\  /__\ \n |  |  |  | ', description: 'A warm fire and familiar faces.' },
    { id: 'forest', name: 'Pine Forest', icon: '♠', art: '  ♠   ♠   ♠ \n ♠♠♠ ♠♠♠ ♠♠♠\n  ||  ||  || ', description: 'A good place to gather food.' },
    { id: 'cabin', name: 'Old Cabin', icon: '⌂', art: '    /\      \n   /__\     \n   |▤ |     ', description: 'A quiet place to rest.' }
  ],
  villagers: [
    { name: 'Mara', role: 'THE GATHERER', trait: 'resourceful', location: 'forest', colour: '#da8d68' },
    { name: 'Rowan', role: 'THE DREAMER', trait: 'gentle', location: 'square', colour: '#aa9ec6' },
    { name: 'Kit', role: 'THE TINKERER', trait: 'curious', location: 'cabin', colour: '#e5bd6c' },
    { name: 'Bea', role: 'THE NEIGHBOUR', trait: 'sociable', location: 'square', colour: '#9ab69a' }
  ]
};
