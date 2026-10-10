import React from 'react'

function App() {
  const handleCheckout = () => {
    fetch('/orders/checkout', { method: 'POST' })
      .then(res => {
        if (!res.ok) {
          throw new Error('Checkout API failed!')
        }
      })
      .catch(err => {
        throw err;
      })
  }

  const handleCrash = () => {
    throw new Error('Order Crash from UI!')
  }

  return (
    <div>
      <h1>Services 2 - Order System</h1>
      <button onClick={handleCheckout}>Checkout (API Error)</button>
      <button onClick={handleCrash}>Order Crash (UI Error)</button>
    </div>
  )
}

export default App
