import React from 'react';

export default function App() {
  const handleFEBug = () => {
    // Calling an undefined function will throw a ReferenceError
    // eslint-disable-next-line no-undef
    undefinedFunction();
  };

  const handleBEBug = async () => {
    const res = await fetch('/api/calculate');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
  };

  return (
    <div>
      <h1>Auto Bug Test</h1>
      <button onClick={handleFEBug}>FE Bug</button>
      <button onClick={handleBEBug}>BE Bug</button>
    </div>
  );
}
